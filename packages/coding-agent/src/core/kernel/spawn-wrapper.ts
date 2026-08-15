/**
 * Optional wrapper for kernel process launches.
 *
 * When PRIME_AGENT_KERNEL_WRAPPER is set, every IPython kernel process (direct
 * spawn and forkserver template) is launched through the given wrapper command,
 * e.g. `sandbox-exec -f /path/profile.sb` on macOS. Child processes started by
 * the kernel (%%bash cells, subprocess) inherit the wrapper's OS-level
 * restrictions.
 *
 * The value is either a JSON array of argv strings (`["sandbox-exec","-f","/p.sb"]`)
 * or a whitespace-separated command line (no argument may contain spaces then).
 * Unset or empty means no wrapping.
 */
export function wrapKernelSpawn(command: string, args: string[]): { command: string; args: string[] } {
	const raw = process.env.PRIME_AGENT_KERNEL_WRAPPER?.trim();
	if (!raw) return { command, args };

	let prefix: string[] | undefined;
	if (raw.startsWith("[")) {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) prefix = parsed.map(String);
		} catch {
			// fall through to whitespace splitting
		}
	}
	prefix ??= raw.split(/\s+/);

	if (prefix.length === 0) return { command, args };
	return { command: prefix[0], args: [...prefix.slice(1), command, ...args] };
}
