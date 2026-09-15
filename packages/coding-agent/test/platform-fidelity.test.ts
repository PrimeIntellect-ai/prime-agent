import { describe, expect, it } from "vitest";
import {
	createDefaultPlatformProbe,
	detectCpuBaseline,
	detectLibc,
	detectOsProductVersion,
	detectPlatformFidelity,
	type PlatformProbe,
	platformFidelity,
	resetPlatformFidelityCacheForTests,
} from "../src/core/platform-fidelity.js";

function probe(overrides: Partial<PlatformProbe> = {}): PlatformProbe {
	return {
		platform: "linux",
		arch: "x64",
		release: () => "6.8.0-45-generic",
		fileExists: () => false,
		readTextFile: () => undefined,
		glibcVersionRuntime: () => undefined,
		...overrides,
	};
}

const AVX2_CPUINFO = [
	"processor\t: 0",
	"vendor_id\t: GenuineIntel",
	"flags\t\t: fpu vme de pse tsc msr pae sse2 avx avx2 bmi2",
	"",
].join("\n");

const NO_AVX2_CPUINFO = [
	"processor\t: 0",
	"vendor_id\t: GenuineIntel",
	"flags\t\t: fpu vme de pse tsc msr pae sse2 avx",
	"",
].join("\n");

const SYSTEM_VERSION_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>ProductName</key>
	<string>macOS</string>
	<key>ProductVersion</key>
	<string>15.6</string>
</dict>
</plist>`;

describe("detectLibc", () => {
	it("reports musl when the musl loader for the architecture exists", () => {
		expect(detectLibc(probe({ fileExists: (path) => path === "/lib/ld-musl-x86_64.so.1" }))).toEqual({
			libc: "musl",
			version: "unknown",
		});
		expect(detectLibc(probe({ arch: "arm64", fileExists: (path) => path === "/lib/ld-musl-aarch64.so.1" }))).toEqual({
			libc: "musl",
			version: "unknown",
		});
	});

	it("prefers the glibc runtime over a musl loader file when both look present", () => {
		// A glibc process on Debian/Ubuntu with the musl package installed
		// still reports glibc: the runtime header sees the actual linkage.
		const result = detectLibc(
			probe({ fileExists: (path) => path.includes("ld-musl"), glibcVersionRuntime: () => "2.39" }),
		);
		expect(result).toEqual({ libc: "glibc", version: "2.39" });
	});

	it("reports glibc with the runtime version when the report header exposes it", () => {
		expect(detectLibc(probe({ glibcVersionRuntime: () => "2.39" }))).toEqual({
			libc: "glibc",
			version: "2.39",
		});
	});

	it("falls back to the glibc loader when no runtime version is exposed", () => {
		expect(detectLibc(probe({ fileExists: (path) => path === "/lib64/ld-linux-x86-64.so.1" }))).toEqual({
			libc: "glibc",
			version: "unknown",
		});
	});

	it("falls back to the 32-bit glibc loader path on ia32", () => {
		expect(detectLibc(probe({ arch: "ia32", fileExists: (path) => path === "/lib/ld-linux.so.2" }))).toEqual({
			libc: "glibc",
			version: "unknown",
		});
	});

	it("reports none off Linux and unknown when nothing matches", () => {
		expect(detectLibc(probe({ platform: "darwin", arch: "arm64" }))).toEqual({
			libc: "none",
			version: "unknown",
		});
		expect(detectLibc(probe({ platform: "win32" })).libc).toBe("none");
		expect(detectLibc(probe()).libc).toBe("unknown");
	});

	it("truncates an absurd glibc version instead of shipping it whole", () => {
		const result = detectLibc(probe({ glibcVersionRuntime: () => "2.".padEnd(500, "9") }));
		expect(result.libc).toBe("glibc");
		expect(result.version).toHaveLength(64);
	});
});

describe("detectCpuBaseline", () => {
	it("reads AVX2 out of /proc/cpuinfo on linux-x64", () => {
		expect(detectCpuBaseline(probe({ readTextFile: () => AVX2_CPUINFO }))).toBe("avx2");
		expect(detectCpuBaseline(probe({ readTextFile: () => NO_AVX2_CPUINFO }))).toBe("no_avx2");
	});

	it("does not confuse avx512 or avx for avx2", () => {
		const avx512 = "flags\t\t: sse2 avx avx512f avx512dq\n";
		expect(detectCpuBaseline(probe({ readTextFile: () => avx512 }))).toBe("no_avx2");
	});

	it("matches avx2 at the end of the flags line", () => {
		expect(detectCpuBaseline(probe({ readTextFile: () => "flags\t\t: sse2 avx avx2" }))).toBe("avx2");
	});

	it("returns unknown when /proc/cpuinfo is unreadable or has no flags line", () => {
		expect(detectCpuBaseline(probe())).toBe("unknown");
		expect(detectCpuBaseline(probe({ readTextFile: () => "processor\t: 0\n" }))).toBe("unknown");
	});

	it("reports not_applicable for non-x64 architectures", () => {
		expect(detectCpuBaseline(probe({ arch: "arm64" }))).toBe("not_applicable");
		expect(detectCpuBaseline(probe({ platform: "darwin", arch: "arm64" }))).toBe("not_applicable");
	});

	it("marks darwin x64 as assumed rather than measured", () => {
		expect(detectCpuBaseline(probe({ platform: "darwin", arch: "x64" }))).toBe("avx2_assumed");
	});

	it("returns unknown on x64 platforms with no probe", () => {
		expect(detectCpuBaseline(probe({ platform: "win32", arch: "x64" }))).toBe("unknown");
	});
});

describe("detectOsProductVersion", () => {
	it("parses the macOS product version from SystemVersion.plist", () => {
		expect(detectOsProductVersion(probe({ platform: "darwin", readTextFile: () => SYSTEM_VERSION_PLIST }))).toBe(
			"15.6",
		);
	});

	it("returns unknown off darwin and when the plist is missing or malformed", () => {
		expect(detectOsProductVersion(probe({ readTextFile: () => SYSTEM_VERSION_PLIST }))).toBe("unknown");
		expect(detectOsProductVersion(probe({ platform: "darwin" }))).toBe("unknown");
		expect(detectOsProductVersion(probe({ platform: "darwin", readTextFile: () => "<plist/>" }))).toBe("unknown");
	});
});

describe("detectPlatformFidelity", () => {
	it("describes an Alpine linux-x64 host without AVX2", () => {
		expect(
			detectPlatformFidelity(
				probe({
					fileExists: (path) => path === "/lib/ld-musl-x86_64.so.1",
					readTextFile: () => NO_AVX2_CPUINFO,
					release: () => "5.15.0-alpine",
				}),
			),
		).toEqual({
			libc: "musl",
			libc_version: "unknown",
			cpu_baseline: "no_avx2",
			os_release: "5.15.0-alpine",
			os_product_version: "unknown",
		});
	});

	it("describes a glibc host that merely has the musl package installed", () => {
		expect(
			detectPlatformFidelity(
				probe({
					fileExists: (path) => path === "/lib/ld-musl-x86_64.so.1",
					readTextFile: () => AVX2_CPUINFO,
					glibcVersionRuntime: () => "2.39",
					release: () => "6.8.0-45-generic",
				}),
			),
		).toEqual({
			libc: "glibc",
			libc_version: "2.39",
			cpu_baseline: "avx2",
			os_release: "6.8.0-45-generic",
			os_product_version: "unknown",
		});
	});

	it("describes a glibc linux-arm64 host", () => {
		expect(detectPlatformFidelity(probe({ arch: "arm64", glibcVersionRuntime: () => "2.35" }))).toEqual({
			libc: "glibc",
			libc_version: "2.35",
			cpu_baseline: "not_applicable",
			os_release: "6.8.0-45-generic",
			os_product_version: "unknown",
		});
	});

	it("never throws when every probe fails", () => {
		const broken: PlatformProbe = {
			platform: "linux",
			arch: "x64",
			release: () => {
				throw new Error("release failed");
			},
			fileExists: () => {
				throw new Error("stat failed");
			},
			readTextFile: () => {
				throw new Error("read failed");
			},
			glibcVersionRuntime: () => {
				throw new Error("report failed");
			},
		};
		expect(detectPlatformFidelity(broken)).toEqual({
			libc: "unknown",
			libc_version: "unknown",
			cpu_baseline: "unknown",
			os_release: "unknown",
			os_product_version: "unknown",
		});
	});
});

describe("platformFidelity", () => {
	it("memoises the result and returns values from the live host probe", () => {
		resetPlatformFidelityCacheForTests();
		const first = platformFidelity();
		expect(platformFidelity()).toBe(first);
		expect(["glibc", "musl", "none", "unknown"]).toContain(first.libc);
		expect(["avx2", "no_avx2", "avx2_assumed", "not_applicable", "unknown"]).toContain(first.cpu_baseline);
		expect(first.os_release).not.toBe("");
	});

	it("builds a usable default probe for the current host", () => {
		const live = createDefaultPlatformProbe();
		expect(live.platform).toBe(process.platform);
		expect(live.arch).toBe(process.arch);
		expect(live.fileExists("/definitely/not/here")).toBe(false);
		expect(live.readTextFile("/definitely/not/here", 16)).toBeUndefined();
	});
});
