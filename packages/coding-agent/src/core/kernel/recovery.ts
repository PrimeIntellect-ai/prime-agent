// Stuck-cell recovery: JEP-91 subshell recovery lane + escalation ladder.
//
// Execution-verified design (see ~/kernel-recovery/ reference suite):
// - interrupt_request (SIGINT) unsticks SYNC hangs (time.sleep, subprocess,
//   %%bash) but is a provable no-op for a stuck top-level await: ipykernel's
//   _cancel_on_sigint only cancels the coroutine future, and a suspended await
//   parks the main thread in the event loop where no exception can be raised.
// - A JEP-91 child subshell (ipykernel >= 7) runs on its own thread over the
//   SAME user namespace and can be created over the control channel while the
//   main shell is wedged. It doubles as (a) a live REPL lane for the agent and
//   (b) the injection vector for stronger cancel weapons.
// - Cross-thread task.cancel() on the main shell's execute task cleanly
//   resolves a stuck await (CancelledError), keeping namespace intact.
// - PyThreadState_SetAsyncExc(main, KeyboardInterrupt) recovers sync-blocking-
//   inside-async cells, but MUST be gated on the main thread being inside user
//   cell code (IPython run_code frame live). Injecting while the thread is
//   parked in event-loop internals kills the loop and the kernel with it
//   (verified experimentally).

/** What the escalation ladder concluded about a stuck execution. */
export type KernelRecoveryOutcome =
	/** A weapon unstuck the cell; the main shell is usable again. */
	| "recovered"
	/** Weapons exhausted (e.g. cell swallows cancellation); the recovery
	 *  subshell still executes, so the agent keeps a live REPL on the shared
	 *  namespace while the stuck cell is abandoned-but-alive. */
	| "recovery-lane-only"
	/** The kernel did not answer a control-channel probe (e.g. a C extension
	 *  holding the GIL). Restart is the only option. */
	| "kernel-unresponsive"
	/** Control channel answers but the subshell lane cannot run code. Restart
	 *  is the only option. */
	| "kernel-wedged"
	/** Nothing was stuck by the time recovery ran. */
	| "no-active-execution";

export type KernelRecoveryWeapon = "interrupt" | "task-cancel" | "async-exc";

export interface KernelRecoveryResult {
	outcome: KernelRecoveryOutcome;
	weapon?: KernelRecoveryWeapon;
}

/** Cancel the main shell's in-flight execute task from the subshell thread.
 *  call_soon_threadsafe is the only loop-safe cross-thread entry point.
 *  Matches exact kernel-machinery qualnames only (the stuck cell's task is
 *  InteractiveShell.run_cell_async on ipykernel 7; the other two cover
 *  wrapper-level tasks across versions) so user tasks with similar names are
 *  never cancelled. */
export const CANCEL_MAIN_TASK_CODE = `
import asyncio as _rec_aio
from ipykernel.kernelapp import IPKernelApp as _RecApp
_rec_loop = _RecApp.instance().kernel.io_loop.asyncio_loop
_REC_KERNEL_TASKS = {
    "InteractiveShell.run_cell_async",
    "IPythonKernel.do_execute",
    "Kernel.execute_request",
}
def _rec_cancel():
    _n = 0
    for _t in _rec_aio.all_tasks(_rec_loop):
        _name = getattr(_t.get_coro(), "__qualname__", "")
        if _name in _REC_KERNEL_TASKS:
            _t.cancel(); _n += 1
    print(f"_rec_cancelled={_n}")
_rec_loop.call_soon_threadsafe(_rec_cancel)
`.trim();

/** Read the main thread's live stack from the subshell (GIL makes this safe).
 *  The main thread is synchronously blocked INSIDE user cell code iff
 *  IPython's run_code frame ("await eval(code_obj, ...)") is live. A suspended
 *  top-level await instead parks the main thread in the loop's _run_once with
 *  no run_code frame. */
export const DIAGNOSE_MAIN_STACK_CODE = `
import sys as _rec_sys, threading as _rec_th, traceback as _rec_tb
_rec_stack = _rec_sys._current_frames().get(_rec_th.main_thread().ident)
if _rec_stack is None:
    print("_rec_in_user=missing")
else:
    _rec_joined = "".join(_rec_tb.format_stack(_rec_stack))
    print(f"_rec_in_user={('in run_code' in _rec_joined) and ('await eval' in _rec_joined)}")
`.trim();

/** Inject KeyboardInterrupt into the main thread, then chase with SIGINT so a
 *  blocked C call (time.sleep etc.) returns via EINTR and the pending
 *  exception is delivered at the next bytecode boundary. Only safe when
 *  DIAGNOSE_MAIN_STACK_CODE reported _rec_in_user=True. */
export const ASYNC_EXC_MAIN_CODE = `
import ctypes as _rec_ct, threading as _rec_th, os as _rec_os, signal as _rec_sig
_rec_n = _rec_ct.pythonapi.PyThreadState_SetAsyncExc(
    _rec_ct.c_ulong(_rec_th.main_thread().ident), _rec_ct.py_object(KeyboardInterrupt))
print(f"_rec_asyncexc={_rec_n}")
_rec_os.kill(_rec_os.getpid(), _rec_sig.SIGINT)
`.trim();
