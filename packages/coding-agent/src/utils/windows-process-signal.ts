import { win32 } from "node:path";

interface ProcessSymbols {
	OpenProcess(access: number, inherit: boolean, pid: number): unknown;
	GetProcessTimes(handle: unknown, creation: unknown, exit: unknown, kernel: unknown, user: unknown): boolean;
	CloseHandle(handle: unknown): boolean;
}

interface ProcessLibrary {
	symbols: ProcessSymbols;
	close(): void;
}

interface BunFfi {
	dlopen(library: string, symbols: Record<string, { args: string[]; returns: string }>): ProcessLibrary;
	ptr(buffer: Uint32Array): unknown;
}

function openProcessLibrary(): ProcessLibrary & { ptr(buffer: Uint32Array): unknown } {
	const ffi = (Reflect.get(globalThis, "Bun") as { FFI?: BunFfi } | undefined)?.FFI;
	if (ffi) {
		const library = ffi.dlopen("kernel32.dll", {
			OpenProcess: { args: ["u32", "bool", "u32"], returns: "ptr" },
			GetProcessTimes: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "bool" },
			CloseHandle: { args: ["ptr"], returns: "bool" },
		});
		return { symbols: library.symbols, close: () => library.close(), ptr: (buffer) => ffi.ptr(buffer) };
	}
	throw new Error("Bun FFI is unavailable");
}

/** Capture from one native HANDLE before scheduling any PID-based helper. */
export function captureWindowsProcessCreationTime(pid: number): string {
	if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new Error("Invalid process ID");
	const library = openProcessLibrary();
	let handle: unknown;
	let creationTime: string;
	let closed = true;
	try {
		handle = library.symbols.OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
		if (!handle) throw new Error("Cannot open process for identity verification");
		const times = Array.from({ length: 4 }, () => new Uint32Array(2));
		const [creation, exit, kernel, user] = times.map((time) => library.ptr(time));
		if (!library.symbols.GetProcessTimes(handle, creation, exit, kernel, user)) {
			throw new Error("Cannot read process creation time");
		}
		creationTime = ((BigInt(times[0]![1]!) << 32n) | BigInt(times[0]![0]!)).toString();
	} finally {
		try {
			if (handle) closed = library.symbols.CloseHandle(handle);
		} finally {
			library.close();
		}
	}
	if (!closed) throw new Error("Cannot close process identity handle");
	return creationTime;
}

export function createWindowsProcessTreeSignal(
	pid: number,
	signal: NodeJS.Signals,
): { command: string; args: string[] } {
	const creationTime = captureWindowsProcessCreationTime(pid);
	// Handle must be cached BEFORE StartTime: .NET then queries the same process object.
	// .Handle requires ALL_ACCESS; denied access or blocked PowerShell fail closed.
	const script = `
$ErrorActionPreference = 'Stop'
$targetId = ${pid}
$process = $null
$code = 2
try {
    $process = [System.Diagnostics.Process]::GetProcessById($targetId)
    $null = $process.Handle
    $actual = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture)
    if ($actual -eq '${creationTime}') {
        & "$env:SystemRoot\\System32\\taskkill.exe" /PID $targetId /T ${signal === "SIGKILL" ? "/F" : ""}
        $code = $LASTEXITCODE
    } else {
        $code = 3
    }
} catch {
    $code = 2
} finally {
    if ($null -ne $process) { $process.Dispose() }
}
exit $code
`;
	return {
		command: win32.join(
			process.env.SystemRoot ?? "C:\\Windows",
			"System32",
			"WindowsPowerShell",
			"v1.0",
			"powershell.exe",
		),
		args: [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(script, "utf16le").toString("base64"),
		],
	};
}
