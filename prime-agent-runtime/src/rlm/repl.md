# REPL runtime protocol

`python -m rlm.repl` starts a CPython REPL runtime that executes code cells in
one persistent `__main__` namespace on a single asyncio event loop. The wire
format is newline-delimited JSON: one object per line, UTF-8, no other framing.
The current protocol version is `3`; the runtime announces it in the `ready`
event.

## Channels

- Requests arrive on fd 0 (stdin).
- Events leave on a private dup of the original fd 1, made before anything else
  runs. Every frame is one locked write sequence, so frames never interleave.
- Python-level writes through `sys.stdout`/`sys.stderr` are intercepted at
  write time, tagged with the writing context's cell id, and shipped straight
  to the protocol.
- fds 1 and 2 are redirected into pipes at startup; pump threads read them and
  ship the bytes as `stdout`/`stderr` events with `id: null` — raw fd bytes
  (`os.write`, `sys.stdout.buffer.write`, C extensions, subprocesses) are never
  attributed to a cell.
  Neither channel can corrupt protocol framing. Ordering is preserved within
  each channel, not across them.
- fd 0 is rebound to `/dev/null` after the reader thread takes it, so user
  `input()` sees EOF instead of consuming protocol frames.

## Requests

| Request | Fields |
|---|---|
| `execute` | `{"type":"execute","id":str,"code":str}` |
| `interrupt` | `{"type":"interrupt","id"?:str}` — no reply |
| `host_reply` | `{"type":"host_reply","id":str,"data":{"status":"ok","result":{...}}}` or an error envelope — no reply |
| `snapshot` | `{"type":"snapshot","id":str,"path":str,"manifest_path":str,"max_bytes"?:int,"max_variable_bytes"?:int,"prune_oversized"?:bool}` |
| `restore` | `{"type":"restore","id":str,"path":str}` |
| `list_names` | `{"type":"list_names","id":str}` |
| `shutdown` | `{"type":"shutdown","id"?:str}` |

Requests other than `interrupt` and `host_reply` run strictly in order, one at
a time. A malformed line
produces `{"event":"error","id":null,"ename":"ProtocolError",...}` and the
runtime keeps serving. Closing stdin is equivalent to `shutdown`.

## Events

- `{"event":"ready","protocol":3,"python":"3.13.11"}` — sent once at startup;
  the handshake. No banner precedes it.
- `{"event":"stdout"|"stderr","id":str|null,"text":str}` — captured output.
  `id` is the cell whose Python execution context performed the write; asyncio
  tasks inherit the spawning cell's id (even after that cell finished). `null`
  for user threads, raw fd writes (`os.write`, C extensions, subprocesses),
  and anything else without provable ownership — bytes read from the fd pipes
  are never attributed to a cell.
- `{"event":"result","id":str,"text":str}` — `repr` of the cell's trailing
  expression when the body ends in an expression whose value is not `None`.
  The value is also bound to `_` in the namespace.
- `{"event":"display","id":str|null,"data":{mime:payload,...}}` — one dict of
  MIME type to JSON payload, shipped verbatim from `emit()`. `id` rides task
  context: an asyncio task spawned by a cell keeps that cell's id even after
  the cell finishes; user threads emit `null`.
- `{"event":"host_request","id":str,"data":{...}}` — one typed request from
  runtime code to the host; the host answers with a `host_reply` request
  carrying the same id.
- `{"event":"error","id":str|null,"ename":str,"evalue":str,"traceback":[str,...]}`
- `{"event":"done","id":str,"status":"ok"|"error"}` — exactly one per id'd
  request, always after all of that request's other events. A snapshot `done`
  adds `saved`, `skipped`, `pruned`, `bytes`; a restore `done` adds `restored`,
  `failed`; a `list_names` `done` adds `names`; a failed snapshot/restore adds
  `reason`. Restoring a missing file reports `status:"ok"` with empty
  `restored`/`failed` lists and `reason:"snapshot not found"`.

Before a cell's `done`, the runtime drains both channels: tagged Python-level
writes ship synchronously from the writing thread, and the fd pipes are fenced
with a marker byte sequence awaited in the pumps, so every byte the cell wrote
synchronously — including direct fd writes — precedes its `done`. Ordering
between a cell's Python-level writes and its raw fd writes is not guaranteed
(two channels).

## Execution

Cells compile with `PyCF_ALLOW_TOP_LEVEL_AWAIT` and run as tasks on the
persistent event loop, so `await` works at top level and background tasks
created by a cell keep running between cells. Each cell's source is registered
in `linecache` under `<cell-N>`, so tracebacks show the offending source line.
Tracebacks are plain `traceback` formatting with the runtime's own frames
stripped, keeping cell and library frames; no colors, no decoration.

## Interrupt

`{"type":"interrupt"}` raises `KeyboardInterrupt` in the running cell. Without
an `id` the interrupt applies to the running request, or — when none is running
yet — to the next queued one; with an `id` it applies to that request only.
An interrupt that arrives before its request starts executing is parked and
delivered the moment the request becomes active, so `execute` + `interrupt`
written back-to-back still interrupts the cell. A request stays
interrupt-targetable until its `done` event is emitted: this covers the
post-run trailing-expression `repr` and output drain. Interrupts for finished
or unknown requests are dropped.

Delivery: the reader thread sends SIGINT to the main thread (also the loop
thread); the handler asks asyncio which task's step the signal interrupted.
On Windows (no `signal.pthread_kill`) the reader instead cancels the active
cell task on the loop, so await-suspended cells interrupt normally but cells
blocked in synchronous code cannot be broken (best-effort parity):

- The active cell's own task is mid-step (sync bytecode such as a `time.sleep`
  loop, or a blocking syscall such as `selectors.select()` woken by EINTR):
  the handler raises `KeyboardInterrupt` directly and it propagates out of the
  cell task.
- The loop is idle in `select()` (the cell is suspended at an `await`) or a
  different task — a background task or the runtime itself — is mid-step:
  raising there would land in the wrong context, so the handler cancels the
  active cell task and the runtime reports the cancellation as a
  `KeyboardInterrupt`. When the mid-step task is a background task, the
  handler also raises `KeyboardInterrupt` into it: a background task blocked
  in synchronous code occupies the only thread, so it receives the
  `KeyboardInterrupt` (and dies with it) to unblock the loop and let the
  cancel take effect. Limitation: the interrupt lands at the await point as a
  cancellation, so user code catching `KeyboardInterrupt` around an `await`
  does not intercept it.

Both paths end with an `error` event (`ename` `KeyboardInterrupt`) and
`done` with `status:"error"`; the runtime keeps serving. When nothing is
running or queued, SIGINT and interrupt requests are ignored.

## Display bridge

`from rlm.repl import emit` inside a cell (or any user thread) ships a
`display` event. `emit(data)` takes one non-empty dict keyed by MIME type
strings; the dict is forwarded verbatim as the event's `data`.

## Host bridge

`await rlm.repl.host_request(data)` ships a `host_request` event with a
runtime-minted id and awaits the matching `host_reply`, returning its `data`
dict verbatim. Replies are routed on the reader thread like `interrupt` —
never through the request queue, since the awaiting cell is itself the
in-flight execute. Replies for unknown ids, or for a request whose awaiting
cell was cancelled, are dropped. `rlm.repl.is_active()` reports whether the
process is serving the protocol (importing the module does not count).

## Snapshot / restore

`snapshot` serializes the user namespace with `dill` (recurse mode), one name
at a time: `_`-prefixed names and
`{rlm, mcp, bash, asyncio, In, Out, get_ipython, exit, quit, open}` are always
skipped; a name whose pickle exceeds `max_variable_bytes` or would push the
total over `max_bytes` is skipped and reported. With `prune_oversized`, only
names exceeding the per-variable cap (`max_variable_bytes`) are also deleted
from the namespace and listed in `pruned`; names skipped for the aggregate
`max_bytes` cap are reported in `skipped` but kept in the namespace. The
payload is written atomically (tmp file + `os.replace`) and a JSON manifest
(`version`, `savedNames`, `skipped`, `pruned`, `bytes`, `pythonVersion`,
`timestamp`) is written to `manifest_path`. A manifest write failure fails the
snapshot (and nothing is pruned).

`restore` loads the payload and revives each name independently; a missing
file yields an ok empty restore with `reason:"snapshot not found"`, a corrupt
file fails with a `reason`, and per-name failures are listed in `failed`.
Names `In`, `Out`, and `get_ipython` in a payload are never restored. `dill` is imported lazily; when unavailable, snapshot and restore
fail with `status:"error"` and a `reason`.

`list_names` replies with `done` carrying `names`: the sorted user-defined
top-level names under the same filter the snapshot applies.

## Shutdown

`shutdown` (or stdin EOF) kills live `rlm.bash` child process groups, replies
`done` (when the request carried an id), stops the loop, and exits 0.
