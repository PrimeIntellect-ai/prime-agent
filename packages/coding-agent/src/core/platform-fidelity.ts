import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { arch as osArch, platform as osPlatform, release as osRelease } from "node:os";

/**
 * Platform-fidelity telemetry.
 *
 * `os_family` + `architecture` alone cannot answer two questions that gate
 * dropping the standalone-Node bootstrap in favour of a single native binary:
 *
 *   1. How many Linux users are on musl (Alpine) instead of glibc?
 *   2. How many x86_64 users run CPUs without AVX2, which the default
 *      Bun linux-x64 build requires?
 *
 * Every probe here is cheap (no subprocesses, bounded reads), memoised for the
 * process, and must never throw: any failure degrades to "unknown".
 */

export type TelemetryLibc = "glibc" | "musl" | "none" | "unknown";

/**
 * "avx2" / "no_avx2" are measured. "avx2_assumed" is reported for Intel Macs,
 * where the value is inferred rather than read (see detectCpuBaseline).
 * "not_applicable" means the CPU is not x86_64, so AVX2 is not a concept that
 * applies. "unknown" means x86_64 but no supported probe (e.g. Windows).
 */
export type TelemetryCpuBaseline = "avx2" | "no_avx2" | "avx2_assumed" | "not_applicable" | "unknown";

export interface PlatformFidelity {
	/** C library family the process is linked against. */
	libc: TelemetryLibc;
	/** glibc runtime version such as "2.39", else "unknown". */
	libc_version: string;
	/** AVX2 availability on x86_64. */
	cpu_baseline: TelemetryCpuBaseline;
	/** Kernel version, e.g. "6.8.0-45-generic" or "24.6.0". */
	os_release: string;
	/** macOS product version such as "15.6"; "unknown" elsewhere. */
	os_product_version: string;
}

/** Injectable environment probe so detection is testable without a real host. */
export interface PlatformProbe {
	platform: string;
	arch: string;
	release: () => string;
	fileExists: (path: string) => boolean;
	readTextFile: (path: string, maxBytes: number) => string | undefined;
	glibcVersionRuntime: () => string | undefined;
}

const UNKNOWN = "unknown" as const;
/** Kernel strings are short; cap anyway so a pathological value cannot bloat an event. */
const MAX_VERSION_LENGTH = 64;
/** The first `flags:` line of /proc/cpuinfo is well inside this window. */
const CPUINFO_READ_BYTES = 16_384;
/** SystemVersion.plist is ~500 bytes of XML. */
const SYSTEM_VERSION_READ_BYTES = 4_096;
const SYSTEM_VERSION_PLIST = "/System/Library/CoreServices/SystemVersion.plist";

/**
 * musl's dynamic loader is named per architecture and always lives at a fixed
 * path, so an existence check is O(1) and does not require reading any file.
 */
const MUSL_LOADER_NAMES: Record<string, string[]> = {
	x64: ["x86_64"],
	arm64: ["aarch64"],
	arm: ["armhf", "arm"],
	ia32: ["i386"],
	ppc64: ["powerpc64le"],
	s390x: ["s390x"],
	riscv64: ["riscv64"],
	loong64: ["loongarch64"],
};

function sanitizeVersion(value: string | undefined): string {
	const trimmed = (value ?? "").trim();
	if (!trimmed) {
		return UNKNOWN;
	}
	return trimmed.slice(0, MAX_VERSION_LENGTH);
}

export function detectLibc(probe: PlatformProbe): { libc: TelemetryLibc; version: string } {
	if (probe.platform !== "linux") {
		return { libc: "none", version: UNKNOWN };
	}

	// The runtime report header observes how THIS process was actually linked,
	// so it outranks filesystem heuristics: a Debian/Ubuntu host with the musl
	// package installed ships a musl loader file but is not a musl host. The
	// header is absent inside compiled musl binaries (glibcVersionRuntime is
	// null there), which only means the decision falls through to the loader
	// checks below — it must not terminate them early in musl's favour.
	const glibcVersion = probe.glibcVersionRuntime();
	if (glibcVersion) {
		return { libc: "glibc", version: sanitizeVersion(glibcVersion) };
	}

	const loaderNames = MUSL_LOADER_NAMES[probe.arch] ?? [];
	for (const loaderName of loaderNames) {
		for (const prefix of ["/lib", "/usr/lib"]) {
			if (probe.fileExists(`${prefix}/ld-musl-${loaderName}.so.1`)) {
				// musl exposes no runtime version symbol worth probing cheaply.
				return { libc: "musl", version: UNKNOWN };
			}
		}
	}

	// No runtime version (some builds omit it): fall back to the presence of a
	// glibc dynamic loader before giving up.
	const glibcLoaders = [
		`/lib/ld-linux-${probe.arch === "arm64" ? "aarch64" : "x86-64"}.so.1`,
		"/lib64/ld-linux-x86-64.so.1",
		"/lib/ld-linux-aarch64.so.1",
		"/lib/ld-linux.so.2",
	];
	if (glibcLoaders.some((path) => probe.fileExists(path))) {
		return { libc: "glibc", version: UNKNOWN };
	}

	return { libc: UNKNOWN, version: UNKNOWN };
}

export function detectCpuBaseline(probe: PlatformProbe): TelemetryCpuBaseline {
	if (probe.arch !== "x64") {
		return "not_applicable";
	}

	if (probe.platform === "linux") {
		const cpuinfo = probe.readTextFile("/proc/cpuinfo", CPUINFO_READ_BYTES);
		if (!cpuinfo) {
			return UNKNOWN;
		}
		const flagsLine = cpuinfo.split("\n").find((line) => line.startsWith("flags"));
		if (!flagsLine) {
			return UNKNOWN;
		}
		return / avx2( |$)/.test(`${flagsLine.slice(flagsLine.indexOf(":") + 1)} `) ? "avx2" : "no_avx2";
	}

	if (probe.platform === "darwin") {
		// Reading machdep.cpu.leaf7_features needs a `sysctl` subprocess, which
		// is not worth the startup cost for this segment. Every Intel Mac that
		// can run a supported macOS (13+) is Haswell or newer, so AVX2 is
		// present — reported as a distinct value so the inference stays visible.
		return "avx2_assumed";
	}

	return UNKNOWN;
}

export function detectOsProductVersion(probe: PlatformProbe): string {
	if (probe.platform !== "darwin") {
		return UNKNOWN;
	}
	const plist = probe.readTextFile(SYSTEM_VERSION_PLIST, SYSTEM_VERSION_READ_BYTES);
	if (!plist) {
		return UNKNOWN;
	}
	const match = /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
	return sanitizeVersion(match?.[1]);
}

export function detectPlatformFidelity(probe: PlatformProbe): PlatformFidelity {
	let libc: TelemetryLibc = UNKNOWN;
	let libcVersion: string = UNKNOWN;
	try {
		({ libc, version: libcVersion } = detectLibc(probe));
	} catch {
		libc = UNKNOWN;
		libcVersion = UNKNOWN;
	}

	let cpuBaseline: TelemetryCpuBaseline = UNKNOWN;
	try {
		cpuBaseline = detectCpuBaseline(probe);
	} catch {
		cpuBaseline = UNKNOWN;
	}

	let release: string = UNKNOWN;
	try {
		release = sanitizeVersion(probe.release());
	} catch {
		release = UNKNOWN;
	}

	let productVersion: string = UNKNOWN;
	try {
		productVersion = detectOsProductVersion(probe);
	} catch {
		productVersion = UNKNOWN;
	}

	return {
		libc,
		libc_version: libcVersion,
		cpu_baseline: cpuBaseline,
		os_release: release,
		os_product_version: productVersion,
	};
}

function readTextFilePrefix(path: string, maxBytes: number): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.allocUnsafe(maxBytes);
		const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
		return buffer.toString("utf8", 0, bytesRead);
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// ignore
			}
		}
	}
}

function glibcVersionRuntime(): string | undefined {
	try {
		// Node and Bun both expose the linked glibc version in the diagnostic
		// report header. Absent on musl and on non-glibc builds.
		const report = process.report?.getReport?.();
		if (!report || typeof report !== "object") {
			return undefined;
		}
		const header = (report as { header?: { glibcVersionRuntime?: unknown } }).header;
		const version = header?.glibcVersionRuntime;
		return typeof version === "string" && version.length > 0 ? version : undefined;
	} catch {
		return undefined;
	}
}

export function createDefaultPlatformProbe(): PlatformProbe {
	return {
		platform: osPlatform(),
		arch: osArch(),
		release: osRelease,
		fileExists: (path) => {
			try {
				return existsSync(path);
			} catch {
				return false;
			}
		},
		readTextFile: readTextFilePrefix,
		glibcVersionRuntime,
	};
}

let cached: PlatformFidelity | undefined;

/** Memoised per process: probes run at most once regardless of event volume. */
export function platformFidelity(): PlatformFidelity {
	if (!cached) {
		try {
			cached = detectPlatformFidelity(createDefaultPlatformProbe());
		} catch {
			cached = {
				libc: UNKNOWN,
				libc_version: UNKNOWN,
				cpu_baseline: UNKNOWN,
				os_release: UNKNOWN,
				os_product_version: UNKNOWN,
			};
		}
	}
	return cached;
}

/** Test-only: drop the memoised value. */
export function resetPlatformFidelityCacheForTests(): void {
	cached = undefined;
}
